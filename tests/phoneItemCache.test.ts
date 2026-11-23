// The sealed item snapshots on the phone (mobile/src/remote/itemCache.ts): scoped by account and machine, a later read is never replaced by an earlier one, a removal beats a save in flight, and what cannot be opened is not shown.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ITEM_BYTES, ITEM_CHATS, boundItems, createItemCache, itemKey, scopePrefix } from '../mobile/src/remote/itemCache.ts';

function world() {
  const rows = new Map<string, string>();
  const order: string[] = [];
  const touch = (k: string) => (order.includes(k) && order.splice(order.indexOf(k), 1), order.push(k));
  const gate: { hold?: Promise<void> } = {};
  const store = {
    read: async (k: string) => rows.get(k) ?? null,
    write: async (k: string, v: string) => (gate.hold && (await gate.hold), rows.set(k, v), touch(k), undefined),
    remove: async (k: string) => (rows.delete(k), order.includes(k) && order.splice(order.indexOf(k), 1), undefined),
    keys: async () => [...order],
    clear: async () => (rows.clear(), (order.length = 0), undefined),
  };
  // the "box" is the plain text with its aad in front, so a copy opened under another key fails as a real tag would
  const crypto = {
    key: async () => new Uint8Array(32),
    randomBytes: (n: number) => new Uint8Array(n).fill(3),
    seal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: string) =>
      new TextEncoder().encode(`${aad}\u0000${new TextDecoder().decode(plain)}`),
    open: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: string) => {
      const text = new TextDecoder().decode(box);
      return text.startsWith(`${aad}\u0000`) ? new TextEncoder().encode(text.slice(aad.length + 1)) : null;
    },
  };
  return { rows, gate, cache: createItemCache({ store, crypto }) };
}
const snap = (rev: number, n = 3, extra: object = {}) => ({
  rev,
  feedSeq: rev * 2,
  items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, text: `t${rev}` })),
  ...extra,
});
const K = itemKey('acct', 'mac1', 'chat1');

test('a saved chat comes back with its revision, feed sequence and generation', async () => {
  const { cache } = world();
  assert.equal(await cache.load(K), null);
  assert.equal(await cache.save(K, cache.begin(K), snap(4, 3, { generation: 'g1' })), true);
  assert.deepEqual(await cache.load(K), snap(4, 3, { generation: 'g1' }));
  await cache.save(K, cache.begin(K), snap(5));
  assert.deepEqual(await cache.load(K), snap(5), 'a newer read replaces it, and no generation is none');
});

test('an earlier read that finishes later does not replace a later one, also while it is being written', async () => {
  const { cache, gate } = world();
  const first = cache.begin(K);
  const second = cache.begin(K);
  assert.equal(await cache.save(K, second, snap(9)), true);
  assert.equal(await cache.save(K, first, snap(8)), false);
  assert.equal((await cache.load(K))!.rev, 9);
  // a slow write of an older read, overtaken by a newer one that is kept first
  let release!: () => void;
  gate.hold = new Promise((r) => (release = r));
  const t3 = cache.begin(K);
  const t4 = cache.begin(K);
  const slow = cache.save(K, t3, snap(10));
  await new Promise((r) => setImmediate(r));
  gate.hold = undefined;
  const fast = cache.save(K, t4, snap(11));
  release();
  assert.equal(await slow, true, 'it began first, so it writes first');
  assert.equal(await fast, true);
  assert.equal((await cache.load(K))!.rev, 11);
});

test('a removal that comes while a save is sealing beats the save', async () => {
  const { cache, rows } = world();
  const pending = cache.save(K, cache.begin(K), snap(1));
  await cache.remove(K);
  assert.equal(await pending, false);
  assert.equal(rows.size, 0);
});

test('a copy moved to another account, machine or chat does not open; a chat with nothing keeps nothing', async () => {
  const { cache, rows } = world();
  await cache.save(K, cache.begin(K), snap(1));
  const moved = itemKey('other', 'mac1', 'chat1');
  rows.set(moved, rows.get(K)!);
  assert.equal(await cache.load(moved), null);
  assert.equal(await cache.save(K, cache.begin(K), { rev: 2, feedSeq: 1, items: [] }), true);
  assert.equal(await cache.load(K), null);
});

test('damaged or foreign contents are not shown', async () => {
  const { cache, rows } = world();
  const seal = async (body: unknown) => {
    await cache.save(K, cache.begin(K), snap(1));
    const saved = JSON.parse(rows.get(K)!);
    const text = `chat-items:${K}\u0000${JSON.stringify(body)}`;
    saved.box = Buffer.from(text).toString('hex');
    rows.set(K, JSON.stringify(saved));
  };
  for (const body of [
    null,
    { rev: 'x', feedSeq: 1, items: [] },
    { rev: 1, feedSeq: 'x', items: [] },
    { rev: 1, feedSeq: 1, items: 'no' },
  ]) {
    await seal(body);
    assert.equal(await cache.load(K), null);
  }
  await seal({ rev: 1, feedSeq: 1, generation: 4, items: [{ id: 'a' }, 7, null] });
  assert.deepEqual(await cache.load(K), { rev: 1, feedSeq: 1, items: [{ id: 'a' }] });
  rows.set(K, 'not json');
  assert.equal(await cache.load(K), null);
});

test('a revoked machine or a left account takes its chats and no one else’s', async () => {
  const { cache } = world();
  const mine = [
    itemKey('acct', 'mac1', 'c1'),
    itemKey('acct', 'mac1', 'c2'),
    itemKey('acct', 'mac2', 'c1'),
    itemKey('acct2', 'mac1', 'c1'),
    itemKey('acct', 'mac10', 'c1'),
  ];
  for (const k of mine) await cache.save(k, cache.begin(k), snap(1));
  await cache.dropScope(scopePrefix('acct', 'mac1'));
  assert.deepEqual(await Promise.all(mine.map(async (k) => !!(await cache.load(k)))), [false, false, true, true, true]);
  await cache.dropScope(scopePrefix('acct'));
  assert.deepEqual(await Promise.all(mine.map(async (k) => !!(await cache.load(k)))), [false, false, false, true, false]);
  await cache.clear();
  assert.equal(await cache.load(mine[3]), null);
});

test('only the newest chats are kept, and a chat’s items are bounded to the newest that fit', async () => {
  const { cache, rows } = world();
  for (let i = 0; i < ITEM_CHATS + 3; i++) {
    const k = itemKey('a', 'm', `c${i}`);
    await cache.save(k, cache.begin(k), snap(1));
  }
  assert.equal(rows.size, ITEM_CHATS);
  assert.equal(await cache.load(itemKey('a', 'm', 'c0')), null);
  assert.ok(await cache.load(itemKey('a', 'm', `c${ITEM_CHATS + 2}`)));
  const big = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, text: 'x'.repeat(ITEM_BYTES / 4) }));
  const kept = boundItems(big);
  assert.ok(kept.length >= 1 && kept.length < 10);
  assert.equal(kept.at(-1)!.id, 'b9');
});

test('a store that fails to write fails that save only, not the ones after it', async () => {
  const { cache, rows } = world();
  const real = rows.set.bind(rows);
  let fail = true;
  rows.set = ((k: string, v: string) => {
    if (fail) throw new Error('disk full');
    return real(k, v);
  }) as typeof rows.set;
  await assert.rejects(cache.save(K, cache.begin(K), snap(1)), /disk full/);
  fail = false;
  assert.equal(await cache.save(K, cache.begin(K), snap(2)), true);
  assert.equal((await cache.load(K))!.rev, 2);
});
